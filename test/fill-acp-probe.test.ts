import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACP_ADAPTERS, formatAcpProbe, formatBytes, probeAcpAgents, type AcpAdapterCatalogueEntry } from '../src/fill/acp-probe.js';

const scratch: string[] = [];
afterEach(() => { for (const folder of scratch.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function scratchFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-acp-probe-'));
  scratch.push(folder);
  return folder;
}

/** Write an executable fake adapter into `folder` and answer with its path. */
function fakeAdapter(folder: string, binary: string, source: string): string {
  const file = join(folder, binary);
  writeFileSync(file, source);
  chmodSync(file, 0o755);
  return file;
}

const ANSWERING_ADAPTER = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
const record = join(dirname(process.argv[1] ?? '.'), 'record.jsonl');
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  appendFileSync(record, line + '\\n');
  const message = JSON.parse(line);
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake-claude-agent', version: '9.9.9' }, authMethods: [{ id: 'claude-login' }] } }) + '\\n');
});
`;

const failingAdapter = `#!/usr/bin/env bun
process.stderr.write('fake adapter: no credentials on this machine\\n');
process.exit(3);
`;

function entry(overrides: Partial<AcpAdapterCatalogueEntry> = {}): AcpAdapterCatalogueEntry {
  return {
    id: 'claude-code',
    label: 'Claude Code',
    launches: [{ binary: 'claude-agent-acp', args: [] }],
    install: { kind: 'npm', package: '@agentclientprotocol/claude-agent-acp', version: '0.93.0', unpackedBytes: 1_956_577, command: 'npm install -g @agentclientprotocol/claude-agent-acp' },
    evidence: 'test catalogue',
    ...overrides,
  };
}

describe('the ACP probe reports what this machine can connect', () => {
  test('an installed adapter is reported connected after the initialize handshake, with no prompt sent', async () => {
    const bin = scratchFolder();
    fakeAdapter(bin, 'claude-agent-acp', ANSWERING_ADAPTER);
    const report = await probeAcpAgents({ cwd: process.cwd(), path: bin, adapters: [entry()] });
    expect(report.findings).toHaveLength(1);
    const found = report.findings[0]!;
    expect(found.status).toBe('connected');
    expect(found.protocolVersion).toBe(1);
    expect(found.agentInfo).toEqual({ name: 'fake-claude-agent', version: '9.9.9' });
    expect(found.authMethods).toEqual(['claude-login']);
    expect(found.executable).toBe(join(bin, 'claude-agent-acp'));
    expect(found.detail).toContain('answered initialize with protocol version 1');
    expect(found.detail).toContain('no prompt was sent');
    const sent = readFileSync(join(bin, 'record.jsonl'), 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as { method?: string; params?: { protocolVersion?: number; clientCapabilities?: unknown } });
    expect(sent.map((message) => message.method)).toEqual(['initialize']);
    expect(sent[0]?.params).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  });

  test('an agent without an adapter names what is missing and how to install it, with the size', async () => {
    const bin = scratchFolder();
    const report = await probeAcpAgents({ cwd: process.cwd(), path: bin, adapters: [entry()] });
    const found = report.findings[0]!;
    expect(found.status).toBe('not-installed');
    expect(found.detail).toContain('nothing named claude-agent-acp is executable on PATH');
    expect(found.detail).toContain('npm install -g @agentclientprotocol/claude-agent-acp');
    expect(found.detail).toContain('@agentclientprotocol/claude-agent-acp 0.93.0, 1.9 MiB unpacked');
    expect(found.install).toEqual({ command: 'npm install -g @agentclientprotocol/claude-agent-acp', package: '@agentclientprotocol/claude-agent-acp', version: '0.93.0', unpackedBytes: 1_956_577 });
    expect(found.executable).toBeUndefined();
  });

  test('a bundled agent names its own program instead of a package', async () => {
    const bin = scratchFolder();
    const report = await probeAcpAgents({
      cwd: process.cwd(),
      path: bin,
      adapters: [entry({
        id: 'omp',
        label: 'omp',
        launches: [{ binary: 'omp', args: ['acp'] }],
        install: { kind: 'bundled', program: 'omp', command: 'install omp from its own project', note: 'this machine has it as the nix package omp 18.10.4.' },
      })],
    });
    expect(report.findings[0]?.detail).toContain('To install it: install omp from its own project — this machine has it as the nix package omp 18.10.4.');
  });

  test('an adapter that cannot connect is reported failed, naming the program and the reason', async () => {
    const bin = scratchFolder();
    fakeAdapter(bin, 'claude-agent-acp', failingAdapter);
    const report = await probeAcpAgents({ cwd: process.cwd(), path: bin, adapters: [entry()] });
    const found = report.findings[0]!;
    expect(found.status).toBe('failed');
    expect(found.executable).toBe(join(bin, 'claude-agent-acp'));
    expect(found.detail).toContain(`has an ACP adapter at ${join(bin, 'claude-agent-acp')} but it did not connect`);
  });

  test('the second name of an adapter is tried when the first is absent', async () => {
    const bin = scratchFolder();
    fakeAdapter(bin, 'claude-code-acp', ANSWERING_ADAPTER);
    const report = await probeAcpAgents({
      cwd: process.cwd(),
      path: bin,
      adapters: [entry({ launches: [{ binary: 'claude-agent-acp', args: [] }, { binary: 'claude-code-acp', args: [] }] })],
    });
    expect(report.findings[0]?.status).toBe('connected');
    expect(report.findings[0]?.executable).toBe(join(bin, 'claude-code-acp'));
  });

  test('the report names the PATH it searched and the agents it holds, and prints one block per agent', async () => {
    const bin = scratchFolder();
    const report = await probeAcpAgents({ cwd: process.cwd(), path: bin, adapters: [entry(), entry({ id: 'codex', label: 'Codex', launches: [{ binary: 'codex-acp', args: [] }] })] });
    expect(report.path).toBe(bin);
    expect(report.findings.map((finding) => finding.id)).toEqual(['claude-code', 'codex']);
    const text = formatAcpProbe(report);
    expect(text).toContain('Agents that connect over ACP on this machine (1 folder on PATH');
    expect(text).toContain('– Claude Code — not installed');
    expect(text).toContain('– Codex — not installed');
    expect(text).toContain('The probe sent no prompt: it stopped at the initialize handshake.');
  });
});

describe('`madarch fill --probe-acp`', () => {
  test('refuses to probe beside the fill options, naming them', () => {
    const cli = join(import.meta.dir, '..', 'scripts', 'madarch.ts');
    const run = Bun.spawnSync([process.execPath, cli, 'fill', '--probe-acp', '--agent', 'omp'], { cwd: join(import.meta.dir, '..') });
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain('--probe-acp reports the agents on this machine and fills nothing: drop --agent');
  });

  test('its help names the flag', () => {
    const cli = join(import.meta.dir, '..', 'scripts', 'madarch.ts');
    const run = Bun.spawnSync([process.execPath, cli, 'fill', '--help'], { cwd: join(import.meta.dir, '..') });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain('--probe-acp');
  });
});

describe('the catalogue names the documented adapters', () => {
  test('every agent the fill considers is listed once, with its launch command and its install', () => {
    expect(ACP_ADAPTERS.map((adapter) => adapter.id)).toEqual(['claude-code', 'codex', 'omp', 'pi']);
    const byId = new Map(ACP_ADAPTERS.map((adapter) => [adapter.id, adapter]));
    expect(byId.get('claude-code')?.install).toMatchObject({ kind: 'npm', package: '@agentclientprotocol/claude-agent-acp', version: '0.93.0' });
    expect(byId.get('claude-code')?.launches.map((launch) => launch.binary)).toEqual(['claude-agent-acp', 'claude-code-acp']);
    expect(byId.get('codex')?.install).toMatchObject({ kind: 'npm', package: '@agentclientprotocol/codex-acp', version: '2.2.2' });
    expect(byId.get('codex')?.launches.map((launch) => launch.binary)).toEqual(['codex-acp', 'codex-acp.js']);
    expect(byId.get('omp')?.launches).toEqual([{ binary: 'omp', args: ['acp'] }]);
    expect(byId.get('pi')?.install).toMatchObject({ kind: 'npm', package: 'pi-acp', version: '0.0.34' });
    for (const adapter of ACP_ADAPTERS) expect(adapter.evidence.length).toBeGreaterThan(20);
  });

  test('a byte count reads in the unit a person expects', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(332_266)).toBe('324 KiB');
    expect(formatBytes(1_748_544)).toBe('1.7 MiB');
    expect(formatBytes(1_956_577)).toBe('1.9 MiB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MiB');
  });
});
