import { describe, expect, test } from 'bun:test';
import { adapterStateKey, agentRows, apiKeyVariable, chosenRow, installOffered, loginStateKey, rowFor, type WizardPayload } from './fill-wizard-model.js';

/** A machine holding one agent of every kind the server can report. */
const payload: WizardPayload = {
  agents: [
    { name: 'claude', available: true, version: 'Claude 1.2.3' },
    { name: 'codex', available: false, reason: 'Not installed' },
    { name: 'omp', available: true, version: 'omp 18.10.4' },
  ],
  chosen: 'claude',
  auth: 'api-key',
  acp: {
    at: '2026-10-19T08:00:00.000Z',
    path: '/usr/local/bin',
    agentsFolder: '/srv/one/madarch/agents',
    findings: [
      { id: 'claude-code', label: 'Claude Code', fillAgent: 'claude', status: 'not-installed', detail: '', login: { state: 'signed-in', detail: '' }, apiKeyEnv: 'ANTHROPIC_API_KEY', install: { command: 'npm install --prefix /srv/one/madarch/agents/claude @agentclientprotocol/claude-agent-acp@0.93.0', kind: 'npm', package: '@agentclientprotocol/claude-agent-acp', version: '0.93.0', installedSize: '299 MiB', byMadarch: true }, evidence: '' },
      { id: 'codex', label: 'Codex', fillAgent: 'codex', status: 'connected', detail: '', login: { state: 'not-signed-in', detail: '' }, apiKeyEnv: 'OPENAI_API_KEY', evidence: '' },
      { id: 'omp', label: 'omp', fillAgent: 'omp', status: 'connected', detail: '', login: { state: 'unknown', detail: '' }, evidence: '' },
      { id: 'pi', label: 'pi', status: 'failed', detail: '', login: { state: 'unknown', detail: '' }, install: { command: 'npm install --prefix /srv/one/madarch/agents/pi pi-acp@0.0.34', kind: 'npm', package: 'pi-acp', version: '0.0.34', byMadarch: true }, evidence: '' },
    ],
  },
};

describe('the wizard reads the ACP probe\'s report as its own rows', () => {
  test('one row per agent the fill can drive, in the probe\'s order, and none for an agent it cannot', () => {
    const rows = agentRows(payload);
    expect(rows.map((row) => row.agent)).toEqual(['claude', 'codex', 'omp']);
    expect(rows.map((row) => row.label)).toEqual(['Claude Code', 'Codex', 'omp']);
    // The agent's own command is what decides whether the person may choose it.
    expect(rows.map((row) => row.selectable)).toEqual([true, false, true]);
    expect(rows[1]?.command?.reason).toBe('Not installed');
    expect(agentRows(undefined)).toEqual([]);
    expect(agentRows({})).toEqual([]);
  });

  test('the chosen row is a choice only while the machine can start it', () => {
    const rows = agentRows(payload);
    expect(chosenRow(rows, 'claude')?.label).toBe('Claude Code');
    expect(chosenRow(rows, 'codex')).toBeUndefined();
    expect(chosenRow(rows, '')).toBeUndefined();
    expect(chosenRow(rows, 'pi')).toBeUndefined();
  });

  test('an install is offered for a missing npm adapter only, and never for one that already connects', () => {
    const rows = agentRows(payload);
    const claude = rows.find((row) => row.agent === 'claude')!;
    expect(installOffered(claude)?.version).toBe('0.93.0');
    expect(installOffered(claude)?.installedSize).toBe('299 MiB');
    // Codex connects already: nothing to install. omp carries ACP itself.
    expect(installOffered(rows.find((row) => row.agent === 'codex')!)).toBeUndefined();
    expect(installOffered(rows.find((row) => row.agent === 'omp')!)).toBeUndefined();
  });

  test('an adapter that is there and did not connect is offered its one install again, and a connected one is not', () => {
    const failedRow = (status: 'failed' | 'connected'): WizardPayload => ({
      ...payload,
      acp: { ...payload.acp!, findings: [{ id: 'claude-code', label: 'Claude Code', fillAgent: 'claude', status, detail: '', login: { state: 'unknown', detail: '' }, apiKeyEnv: 'ANTHROPIC_API_KEY', install: { command: 'npm install --prefix /srv/one/madarch/agents/claude @agentclientprotocol/claude-agent-acp@0.93.0', kind: 'npm', package: '@agentclientprotocol/claude-agent-acp', version: '0.93.0', installedSize: '299 MiB', byMadarch: true }, evidence: '' }] },
    });
    expect(installOffered(agentRows(failedRow('failed'))[0]!)?.version).toBe('0.93.0');
    expect(installOffered(agentRows(failedRow('connected'))[0]!)).toBeUndefined();
  });

  test('every state the probe can report has its own words', () => {
    expect(adapterStateKey('connected')).toBe('wizard.adapterConnected');
    expect(adapterStateKey('not-installed')).toBe('wizard.adapterMissing');
    expect(adapterStateKey('failed')).toBe('wizard.adapterFailed');
    expect(loginStateKey('signed-in')).toBe('wizard.loginSignedIn');
    expect(loginStateKey('not-signed-in')).toBe('wizard.loginNotSignedIn');
    expect(loginStateKey('unknown')).toBe('wizard.loginUnknown');
  });

  test('the key variable follows the agent, not whether its command is installed', () => {
    // A stored choice whose command is gone still reads its own variable: the
    // row is not selectable, and the API-key radio of that agent still names
    // the key ANTHROPIC_API_KEY.
    const rows = agentRows(payload);
    expect(rowFor(rows, 'codex')?.selectable).toBe(false);
    expect(apiKeyVariable(rowFor(rows, 'codex'))).toBe('OPENAI_API_KEY');
    expect(apiKeyVariable(chosenRow(rows, 'codex'))).toBeUndefined();
  });

  test('an API-key choice names the variable the agent\'s own client reads, and nothing else', () => {
    const rows = agentRows(payload);
    expect(apiKeyVariable(rows.find((row) => row.agent === 'claude'))).toBe('ANTHROPIC_API_KEY');
    expect(apiKeyVariable(rows.find((row) => row.agent === 'codex'))).toBe('OPENAI_API_KEY');
    expect(apiKeyVariable(rows.find((row) => row.agent === 'omp'))).toBeUndefined();
    expect(apiKeyVariable(undefined)).toBeUndefined();
  });
});
