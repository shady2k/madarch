/**
 * The first-fill wizard's own reading of what the server answers: one row per
 * agent madarch can fill with, each carrying what the ACP probe found (its
 * adapter's state, whether the agent is signed in, and the install madarch
 * would run) and whether the agent's own command is installed — the thing the
 * landed fill drives. It is a plain module rather than a part of the view so
 * the reading is checked without a browser.
 *
 * Nothing here decides what to install or what to start: the rows say what the
 * server reported, and the view shows it (docs/changes/madarch-tzte.22.5).
 */

/** How the fill's own agent command answered `--version`, as the server reports it. */
export interface WizardAgentCommand {
  name: 'claude' | 'codex' | 'omp';
  available: boolean;
  version?: string;
  reason?: string;
}

/** Whether an agent is signed in, as its own sign-in store tells the probe. */
export type WizardLoginState = 'signed-in' | 'not-signed-in' | 'unknown';

/** One adapter's install, as madarch would run it: an npm package at one pinned version. */
export interface WizardAdapterInstall {
  command: string;
  kind: 'npm' | 'bundled';
  package?: string;
  version?: string;
  unpackedBytes?: number;
  unpackedSize?: string;
  installedBytes?: number;
  installedSize?: string;
  folder?: string;
  byMadarch: boolean;
  reason?: string;
}

/** One agent as the ACP probe found it on this machine. */
export interface WizardAcpFinding {
  id: string;
  label: string;
  fillAgent?: 'claude' | 'codex' | 'omp';
  status: 'connected' | 'not-installed' | 'failed';
  detail: string;
  executable?: string;
  foundIn?: 'madarch' | 'path';
  protocolVersion?: number;
  agentInfo?: { name?: string; title?: string; version?: string };
  authMethods?: readonly string[];
  login: { state: WizardLoginState; detail: string };
  install?: WizardAdapterInstall;
  apiKeyEnv?: string;
  evidence: string;
}

/** What `GET /api/fill/wizard` answers, as the view reads it. */
export interface WizardPayload {
  agents?: readonly WizardAgentCommand[];
  chosen?: '' | 'claude' | 'codex' | 'omp';
  auth?: 'subscription' | 'api-key';
  model?: string;
  runExists?: boolean;
  acp?: { at: string; path: string; agentsFolder: string; findings: readonly WizardAcpFinding[] };
}

/** One agent the wizard offers: what the fill can drive, and what the probe found for it. */
export interface WizardAgentRow {
  agent: 'claude' | 'codex' | 'omp';
  label: string;
  /** The ACP finding for this agent: its adapter, its sign-in and its install. */
  adapter: WizardAcpFinding;
  /** The agent's own command, when the server reports one for it. */
  command: WizardAgentCommand | undefined;
  /** Whether the person may choose it: its own command is installed. */
  selectable: boolean;
}

/** The agents the wizard offers, in the catalogue's order. */
export function agentRows(payload: WizardPayload | undefined): WizardAgentRow[] {
  const findings = payload?.acp?.findings ?? [];
  const rows: WizardAgentRow[] = [];
  for (const finding of findings) {
    if (finding.fillAgent === undefined) continue;
    const command = (payload?.agents ?? []).find((agent) => agent.name === finding.fillAgent);
    rows.push({ agent: finding.fillAgent, label: finding.label, adapter: finding, command, selectable: command?.available === true });
  }
  return rows;
}

/** The row the person chose, when the choice is one this machine can start. */
export function chosenRow(rows: readonly WizardAgentRow[], chosen: string): WizardAgentRow | undefined {
  return rows.find((row) => row.agent === chosen && row.selectable);
}

/**
 * The row of one agent, whether or not this machine can start it: what the
 * probe reported about an agent is the agent's, and a missing command does not
 * change which variable its API key comes from.
 */
export function rowFor(rows: readonly WizardAgentRow[], chosen: string): WizardAgentRow | undefined {
  return rows.find((row) => row.agent === chosen);
}

/**
 * Whether madarch can install this agent's adapter itself: an npm adapter that
 * is not there — missing, or there and did not connect, which one install of
 * the pinned version fixes. An adapter that already connects is not offered
 * again, and one that carries ACP in its own program is never installed by
 * madarch at all.
 */
export function installOffered(row: WizardAgentRow): WizardAdapterInstall | undefined {
  const install = row.adapter.install;
  if (install === undefined || install.kind !== 'npm' || !install.byMadarch) return undefined;
  if (row.adapter.status === 'connected') return undefined;
  return install;
}

/** The translation key of an adapter's state, as the row says it. */
export function adapterStateKey(status: WizardAcpFinding['status']): 'wizard.adapterConnected' | 'wizard.adapterMissing' | 'wizard.adapterFailed' {
  if (status === 'connected') return 'wizard.adapterConnected';
  if (status === 'failed') return 'wizard.adapterFailed';
  return 'wizard.adapterMissing';
}

/** The translation key of an agent's sign-in state, as the row says it. */
export function loginStateKey(state: WizardLoginState): 'wizard.loginSignedIn' | 'wizard.loginNotSignedIn' | 'wizard.loginUnknown' {
  if (state === 'signed-in') return 'wizard.loginSignedIn';
  if (state === 'not-signed-in') return 'wizard.loginNotSignedIn';
  return 'wizard.loginUnknown';
}

/**
 * The environment variable an API-key fill of this agent reads its key from,
 * or `undefined` for an agent whose client reads no key madarch knows: the key
 * is the agent's own business, and madarch only names the variable.
 */
export function apiKeyVariable(row: WizardAgentRow | undefined): string | undefined {
  return row?.adapter.apiKeyEnv;
}
